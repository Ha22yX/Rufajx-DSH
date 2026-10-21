"""Prepare pinned, self-contained Windows Office/PDF/OCR assets for the client.

Run with build-machine Python 3.12. Nothing is installed into that interpreter,
an employee profile, or another agent. Runtime startup never downloads packages.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "preinstalled.lock.json"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def artifact(entry, cache):
    target = cache / entry["file"]
    # Reuse the initial wheel download directory, without trusting its contents.
    previous = cache / "office-pdf-wheels" / entry["file"]
    if not target.exists() and previous.is_file():
        shutil.copyfile(previous, target)
    if not target.exists():
        temporary = target.with_suffix(target.suffix + ".download")
        print("Downloading", entry["file"], flush=True)
        with urllib.request.urlopen(entry["url"], timeout=120) as response, temporary.open("wb") as out:
            shutil.copyfileobj(response, out)
        if digest(temporary) != entry["sha256"]:
            raise RuntimeError(f"Downloaded checksum mismatch: {entry['file']}")
        temporary.replace(target)
    if digest(target) != entry["sha256"]:
        raise RuntimeError(f"Cached checksum mismatch: {entry['file']}")
    return target


def extract(archive, destination):
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            resolved = (destination / entry.filename).resolve()
            if not resolved.is_relative_to(destination.resolve()) or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise RuntimeError("Archive contains an unsafe path or symlink")
        bundle.extractall(destination)


def publish(source, destination):
    # First preparation only. Upgrades deliberately require a separate staged
    # runtime, so a running employee process never sees half-replaced binaries.
    if destination.exists():
        raise RuntimeError(f"Refusing to overwrite an existing runtime component: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source.replace(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "win32" or sys.version_info[:2] != (3, 12):
        raise RuntimeError("Use 64-bit Windows build-machine Python 3.12")
    runtime, cache = args.runtime.resolve(), args.cache.resolve()
    if not (runtime / "rufa-runtime.json").is_file():
        raise RuntimeError("A prepared pinned Harness runtime is required")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if json.loads((runtime / "rufa-runtime.json").read_text())["upstreamCommit"] != lock["upstreamCommit"]:
        raise RuntimeError("The runtime revision differs from the preinstalled plugin lock")
    marker = runtime / "rufa-preinstalled.json"
    lock_hash = digest(LOCK_PATH)
    if marker.exists():
        if json.loads(marker.read_text())["lockSha256"] != lock_hash:
            raise RuntimeError("Prepare a fresh runtime for a different dependency lock")
        print("Pinned Office/PDF/OCR dependencies already prepared")
        return
    cache.mkdir(parents=True, exist_ok=True)
    python_zip = artifact(lock["python"], cache)
    source_zips = {entry["id"]: artifact(entry, cache) for entry in lock["sources"]}
    wheels = [artifact(entry, cache) for entry in lock["wheels"]]
    with tempfile.TemporaryDirectory(prefix=".company-preinstall-", dir=runtime) as temporary:
        stage = Path(temporary)
        python = stage / "company-python"
        extract(python_zip, python)
        (python / "python312._pth").write_text("python312.zip\n.\nLib/site-packages\nimport site\n", encoding="ascii")
        subprocess.run([sys.executable, "-m", "pip", "install", "--no-index", "--no-deps", "--no-compile",
                        "--target", str(python / "Lib/site-packages"), *map(str, wheels)], check=True)
        subprocess.run([str(python / "python.exe"), "-I", "-c",
                        "import docx,pptx,openpyxl,pandas,pymupdf,pypdfium2,rapidocr_onnxruntime; print('Bundled Python imports OK')"], check=True)
        for key, archive in source_zips.items():
            extract(archive, stage / key)
        ocr_source = next((stage / "ocr").iterdir())
        pdf_source = next((stage / "pdf").iterdir())
        ocr = stage / "ocr-package"
        ocr.mkdir()
        # Include source/license alongside the published files. No upstream
        # installer runs, and no old peer runtime is fetched from npm.
        for name in ["package.json", "lib", "src", "extract.py", "requirements.txt", "cordis.patch.yml",
                     "LICENSE", "README.md", "README.zh-CN.md", "THIRD_PARTY_NOTICES.md"]:
            src = ocr_source / name
            shutil.copytree(src, ocr / name) if src.is_dir() else shutil.copy2(src, ocr / name)
        pdf = stage / "pdf-tools"
        pdf.mkdir()
        for name in ["pdf_tools.py", "LICENSE", "README.md", "requirements.txt"]:
            shutil.copy2(pdf_source / name, pdf / name)
        # Unused personal-directory MCP/drop servers are not shipped or started.
        (python / "rufa-dependencies.json").write_text(json.dumps(lock["wheels"], indent=2) + "\n", encoding="utf-8")
        publish(python, runtime / "company-python")
        publish(ocr, runtime / "node_modules/dsh-file-upload-ocr-plugin")
        publish(pdf, runtime / "company-tools/dsh-read-pdf")
    marker.write_text(json.dumps({"schema": 1, "lockSha256": lock_hash, "python": lock["python"]["version"],
                                 "sources": lock["sources"], "wheelCount": len(wheels)}, indent=2) + "\n", encoding="utf-8")
    print("Prepared pinned Office/PDF/OCR dependencies; no employee profile was changed")


if __name__ == "__main__":
    main()
